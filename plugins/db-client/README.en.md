**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# db-client — database connection manager plugin

A pi-web-ui UI plugin: a slimmed-down web take on [vscode-database-client](https://github.com/cweijan/vscode-database-client)
— connection management + database/table tree browsing + table structure view + paginated data browsing + SQL query editor.

## Supported databases

| Type            | Driver                 | Default port  | Notes                                                                                                              |
| --------------- | ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| MySQL / MariaDB | mysql2                 | 3306          | Databases/tables/views, columns + indexes + DDL (SHOW CREATE TABLE), pagination and sorting, SQL                   |
| PostgreSQL      | pg                     | 5432          | public schema tables/materialized views/plain views, primary keys/indexes, cross-database browsing, SQL            |
| SQLite          | node:sqlite (built-in) | — (file path) | Opens a local .db file with zero extra dependencies; PRAGMA structure, pagination, SQL, row editing (≥ Node 22.13) |
| SQL Server      | mssql                  | 1433          | Automatic schema detection, OFFSET/FETCH pagination, SQL                                                           |
| MongoDB         | mongodb                | 27017         | Database/collection tree, document pagination (JSON filter such as `{"age":{"$gt":18}}`), indexes; no SQL          |
| Redis           | ioredis                | 6379          | Key pattern scan, key details (type/TTL/size/value preview), raw command line                                      |

Driver dependencies are **not shipped with the package**: the first activation runs `npm install` into the plugin directory automatically (you can also click 「安装驱动」(Install drivers) in the left panel).
With only some drivers installed, the matching types still work; types that are not installed return a friendly message when connecting.

## Install / uninstall / update

```bash
# ── install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client
pi-web-ui install plugins/db-client      # or a local directory (development)
# optional: --data-dir <dir> to use a custom data directory (default ~/.pi-web)

# ── list ──
pi-web-ui plugins                            # list installed plugins and their ids

# ── update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client --force
                                             # --force reinstalls over the top, i.e. updates
                                             # ⚠ back up db-connections.json (connection credentials) in the plugin directory first

cp -r plugins/db-client ~/.pi-web/plugins/  # local development: run npm run build after editing src, then copy
                                             # Windows: %USERPROFILE%\.pi-web\plugins\db-client

# ── uninstall ──
pi-web-ui uninstall db-client                # removes the plugin directory (db-connections.json goes with it)
# manual: rm -rf ~/.pi-web/plugins/db-client
```

Refresh the browser and it takes effect (a 🗄️ tab shows up in the top bar).

## Features

- **Connection management**: create / edit / delete / test connections; config is stored locally in `<dataDir>/plugins/db-client/db-connections.json`, **connection passwords go to the host's encrypted secrets (`host.secrets`, AES-256-GCM), no plaintext in the file anymore** (older hosts without the secrets facility fall back to plaintext; credentials embedded in `uri` cannot be split reliably and stay in the file); echoes are masked
- **Multiple connections at once**: up to 8 open simultaneously, isolated from each other, with an automatic notice on disconnect
- **Data browsing**: pagination (first/previous/next/last page), click a column header to sort, NULL shown de-emphasized, row counts (estimated for large tables)
- **Structure view**: column list (type/nullable/primary key/default/comment), indexes, DDL text
- **SQL editor**: Ctrl/Cmd+Enter to run, shows elapsed time and affected row count, results rendered as a table
- **MongoDB**: collection browsing + paginated document queries with JSON filters
- **Row editing**: double-click a cell to change the value (Enter commits / Esc cancels), hover to delete a single row, 「＋ 新增行」(Add row) form;
  SQLite tables without a primary key are located by rowid automatically; typing NULL (uppercase) writes SQL NULL
- **MongoDB editing**: visual JSON document editing (✎) / delete / insert; a hex-string _id is restored to ObjectId automatically
- **Redis editing**: edit string values online and save
- **Redis**: pattern-scanned key list, TTL/type badges, values rendered by type (string/hash/list/set/zset/stream), arbitrary raw commands

## Protocol

Uplink `{ action, reqId, ... }`, downlink response `{ res: true, reqId, ok, ... }` (matched by reqId);
events `{ event: "conn_closed", ... }` targeted at one client; state broadcasts `{ kind: "state", state }`.
See the header comment in `index.mjs`.

## Regression test

```bash
npm run build:server
node tests/db-client-test.mjs   # port 8968, SQLite end-to-end protocol test (zero token, zero dependencies, already in the run-smoke list)
```
