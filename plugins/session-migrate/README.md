# 会话迁移 Session Migrate 🔄

扫描 `~/.omp/agent/sessions` 与 `~/.pi/agent/sessions` 的历史会话，只读预览后一键导入 pi 会话库（issue 286 Phase 1）；同时提供会话**导出 / 上传导入**，用于备份与跨机器搬运（issue #887）。

Scan history sessions under `~/.omp/agent/sessions` and `~/.pi/agent/sessions`, preview read-only, then import into the pi session store (issue 286 Phase 1). Also exports and re-imports session `.jsonl` files for backup and cross-machine moves (issue #887).

- AI tools: `session_migrate_scan` / `session_migrate_import` / `session_migrate_export` / `session_migrate_from_jsonl`
- HTTP:
  - `GET /plugins-api/session-migrate/scan`
  - `POST /plugins-api/session-migrate/import`
  - `GET /plugins-api/session-migrate/export?file=<会话库内 .jsonl>`（浏览器直接下载）
  - `POST /plugins-api/session-migrate/import-file`（JSON `{text,targetCwd,mode}` 或 `application/octet-stream` 原始文本 + `x-target-cwd` / `x-session-mode`）
- 规则 Rules: model_change 的 `model:'p/m'` 拆成 provider+modelId；删除 message.attribution；目标 id 已存在跳过；可选 cwd 重定向。

## 导出 / 上传导入（#887）

- **导出**：视图里 pi / checkbox 列表每行有「⬇ 导出」，走 `/export` 下载原始 `.jsonl`（不做任何改写）。路由只放行 `~/.pi/agent/sessions` 与 `~/.omp/agent/sessions` 里的 `.jsonl/.json`——插件路由不允许变成任意文件下载器。
- **上传导入**：选一个别人导出的 `.jsonl` 上传，首行必须是 pi 会话头（`type:"session"` + `id`）；其余行宽容保留（历史版本可能有插件私有事件，坏行只统计不阻断）。上限 64MB，超过请走磁盘目录导入。
- **重名三选一**：目标 id 已存在时返回 409，视图里出现「覆盖原会话 / 另存副本 / 取消」。覆盖就地把旧文件写回（不产生平行会话）；另存副本换新 session id。
- **落盘位置与 SDK 逐字一致**：目录 `--<cwd 去掉前导斜杠、/ \ : 换成 ->--`，文件名 `<ISO 时间>_<sessionId>.jsonl`。否则文件落在 SDK 不扫的目录里，导入完在左栏「历史会话」里看不到（旧版的 `escapeCwd` 编码不对，已修）。
