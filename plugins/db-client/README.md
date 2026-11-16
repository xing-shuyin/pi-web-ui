[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# db-client —— 数据库连接管理插件

pi-web-ui 界面插件，类似 [vscode-database-client](https://github.com/cweijan/vscode-database-client)
的网页版精简体验：连接管理 + 库表树浏览 + 表结构查看 + 数据分页浏览 + SQL 查询编辑器。

## 支持的数据库

| 类型 | 驱动 | 默认端口 | 说明 |
| --- | --- | --- | --- |
| MySQL / MariaDB | mysql2 | 3306 | 库/表/视图、列+索引+DDL（SHOW CREATE TABLE）、分页排序、SQL |
| PostgreSQL | pg | 5432 | public schema 表/物化视图/普通视图、主键/索引、跨库切换浏览、SQL |
| SQLite | node:sqlite（内置） | —（文件路径） | 打开本地 .db 文件，零额外依赖；PRAGMA 结构、分页、SQL、行编辑（≥ Node 22.13） |
| SQL Server | mssql | 1433 | 自动探测 schema、OFFSET/FETCH 分页、SQL |
| MongoDB | mongodb | 27017 | 库/集合树、文档分页（JSON 过滤条件如 `{"age":{"$gt":18}}`）、索引；不支持 SQL |
| Redis | ioredis | 6379 | 键模式扫描、键详情（类型/TTL/大小/值预览）、原始命令行 |

驱动依赖**不随包分发**：首次激活自动 `npm install` 到插件目录（也可点左栏「安装驱动」手动触发）。
只装了部分驱动也能用对应类型，未装的类型在连接时报友好提示。

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client
pi-web-ui install plugins/db-client      # 或本地目录（开发态）
# 可选：--data-dir <dir> 自定义数据目录（默认 ~/.pi-web）

# ── 查看 ──
pi-web-ui plugins                            # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client --force
                                             # --force 覆盖重装即更新
                                             # ⚠ 先备份插件目录里的 db-connections.json（连接凭据）

cp -r plugins/db-client ~/.pi-web/plugins/  # 本地开发态：改完 src 后先 npm run build 再拷贝
                                             # Windows: %USERPROFILE%\.pi-web\plugins\db-client

# ── 卸载 ──
pi-web-ui uninstall db-client                # 移除插件目录（db-connections.json 一并删除）
# 手动方式：rm -rf ~/.pi-web/plugins/db-client
```

刷新浏览器即生效（顶栏出现 🗄️ 标签页）。

## 功能

- **连接管理**：新建 / 编辑 / 删除 / 测试连接；配置存本机 `<dataDir>/plugins/db-client/db-connections.json`，**连接密码走宿主加密机密（`host.secrets`，AES-256-GCM），文件里不再落明文**（旧版宿主没有机密设施时回退明文；`uri` 里内嵌的凭据无法可靠拆分，仍在文件里），回显脱敏
- **多连接并存**：最多同时打开 8 个，互不干扰，断线自动提示
- **数据浏览**：分页（首页/上下页/末页）、点击列头排序、NULL 弱化显示、行数统计（大表用估算行数）
- **结构查看**：列清单（类型/可空/主键/默认值/备注）、索引、DDL 文本
- **SQL 编辑器**：Ctrl/Cmd+Enter 运行，显示耗时与影响行数，结果表格化
- **MongoDB**：集合浏览 + JSON 过滤条件分页查文档
- **行编辑**：双击单元格直接改值（Enter 提交 / Esc 取消）、悬停删除单行、「＋ 新增行」表单；
  无主键的 SQLite 表自动用 rowid 定位；输入 NULL（大写）表示写入 SQL NULL
- **MongoDB 编辑**：文档 JSON 可视化编辑（✎）/ 删除 / 新增；_id 十六进制字符串自动还原 ObjectId
- **Redis 编辑**：字符串键值在线修改保存
- **Redis**：pattern 扫描键列表、TTL/类型徽标、值按类型渲染（string/hash/list/set/zset/stream）、任意原始命令

## 协议

上行 `{ action, reqId, ... }`，下行响应 `{ res: true, reqId, ok, ... }`（reqId 匹配）；
事件 `{ event: "conn_closed", ... }` 定向推送；状态广播 `{ kind: "state", state }`。
详见 `index.mjs` 头部注释。

## 回归测试

```bash
npm run build:server
node tests/db-client-test.mjs   # 端口 8968，SQLite 全链路协议测试（零 token 零依赖，已进 run-smoke 清单）
```
