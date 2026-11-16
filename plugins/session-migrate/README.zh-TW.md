[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 會話遷移 Session Migrate 🔄

掃描 `~/.omp/agent/sessions` 與 `~/.pi/agent/sessions` 的歷史會話，只讀預覽後一鍵匯入 pi 會話庫（issue 286 Phase 1）；同時提供會話**匯出 / 上傳匯入**，用於備份與跨機器搬運（issue #887）。

Scan history sessions under `~/.omp/agent/sessions` and `~/.pi/agent/sessions`, preview read-only, then import into the pi session store (issue 286 Phase 1). Also exports and re-imports session `.jsonl` files for backup and cross-machine moves (issue #887).

- AI tools: `session_migrate_scan` / `session_migrate_import` / `session_migrate_export` / `session_migrate_from_jsonl`
- HTTP:
  - `GET /plugins-api/session-migrate/scan`
  - `POST /plugins-api/session-migrate/import`
  - `GET /plugins-api/session-migrate/export?file=<會話庫內 .jsonl>`（瀏覽器直接下載）
  - `POST /plugins-api/session-migrate/import-file`（JSON `{text,targetCwd,mode}` 或 `application/octet-stream` 原始文本 + `x-target-cwd` / `x-session-mode`）
- 規則 Rules: model_change 的 `model:'p/m'` 拆成 provider+modelId；刪除 message.attribution；目標 id 已存在跳過；可選 cwd 重定向。

## 匯出 / 上傳匯入（#887）

- **匯出**：視圖裡 pi / checkbox 列表每行有「⬇ 匯出」，走 `/export` 下載原始 `.jsonl`（不做任何改寫）。路由只放行 `~/.pi/agent/sessions` 與 `~/.omp/agent/sessions` 裡的 `.jsonl/.json`——外掛路由不允許變成任意檔案下載器。
- **上傳匯入**：選一個別人匯出的 `.jsonl` 上傳，首行必須是 pi 會話頭（`type:"session"` + `id`）；其餘行寬容保留（歷史版本可能有外掛私有事件，壞行只統計不阻斷）。上限 64MB，超過請走磁碟目錄匯入。
- **重名三選一**：目標 id 已存在時返回 409，視圖裡出現「覆蓋原會話 / 另存副本 / 取消」。覆蓋就地把舊檔案寫回（不產生平行會話）；另存副本換新 session id。
- **落盤位置與 SDK 逐字一致**：目錄 `--<cwd 去掉前導斜槓、/ \ : 換成 ->--`，檔名 `<ISO 時間>_<sessionId>.jsonl`。否則檔案落在 SDK 不掃的目錄裡，匯入完在左欄「歷史會話」裡看不到（舊版的 `escapeCwd` 編碼不對，已修）。
