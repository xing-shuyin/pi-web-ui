**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Session Migration Session Migrate 🔄

Scans history sessions under `~/.omp/agent/sessions` and `~/.pi/agent/sessions`, previews them read-only, then imports them into the pi session store in one click (issue 286 Phase 1); it also provides session **export / upload import** for backups and cross-machine moves (issue #887).

Scan history sessions under `~/.omp/agent/sessions` and `~/.pi/agent/sessions`, preview read-only, then import into the pi session store (issue 286 Phase 1). Also exports and re-imports session `.jsonl` files for backup and cross-machine moves (issue #887).

- AI tools: `session_migrate_scan` / `session_migrate_import` / `session_migrate_export` / `session_migrate_from_jsonl`
- HTTP:
  - `GET /plugins-api/session-migrate/scan`
  - `POST /plugins-api/session-migrate/import`
  - `GET /plugins-api/session-migrate/export?file=<会话库内 .jsonl>` (the browser downloads it directly)
  - `POST /plugins-api/session-migrate/import-file` (JSON `{text,targetCwd,mode}`, or raw text as `application/octet-stream` + `x-target-cwd` / `x-session-mode`)
- Rules: split `model:'p/m'` of model_change into provider+modelId; drop message.attribution; skip when the target id already exists; optional cwd redirect.

## Export / upload import (#887)

- **Export**: every row of the pi / checkbox list in the view has 「⬇ 导出」(Export), which downloads the raw `.jsonl` through `/export` (no rewriting at all). The route only allows `.jsonl/.json` under `~/.pi/agent/sessions` and `~/.omp/agent/sessions` — a plugin route must not turn into an arbitrary file downloader.
- **Upload import**: upload a `.jsonl` someone else exported; the first line must be the pi session header (`type:"session"` + `id`); the remaining lines are kept leniently (older versions may hold plugin-private events, so bad lines are only counted, not blocking). The limit is 64MB; anything larger must go through directory import from disk.
- **Three choices on a name clash**: when the target id already exists it returns 409 and the view offers 「覆盖原会话 / 另存副本 / 取消」(Overwrite the original session / Save as a copy / Cancel). Overwrite writes back in place to the old file (no parallel session is produced); save-as-copy switches to a new session id.
- **On-disk layout matches the SDK byte for byte**: the directory is `--<cwd 去掉前导斜杠、/ \ : 换成 ->--` and the file name is `<ISO 时间>_<sessionId>.jsonl`. Otherwise the file lands in a directory the SDK does not scan and is invisible under 「历史会话」(History sessions) in the left panel after the import (older versions had the `escapeCwd` encoding wrong, now fixed).
