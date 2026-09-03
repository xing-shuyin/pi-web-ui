/**
 * db-client 插件协议回归测试（零 token、自包含、零外部依赖）。
 *
 * SQLite 用 Node 内置 node:sqlite 走全链路：连接配置 CRUD（凭据脱敏）→ connect →
 * tables_list / describe / page（分页+排序）/ query_exec → 断开 → 事件 → 重连。
 * 不预装任何驱动（PI_DB_CLIENT_NO_AUTOINSTALL 阻止后台全量安装，测试机不出网）。
 *
 * 运行：先 npm run build:server，再 node tests/db-client-test.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8968;
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_ID = "db-client";
const SRC = join(import.meta.dirname, "..", "plugins", PLUGIN_ID);

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-dbclient-test-"));
const plugDir = join(dataDir, "plugins", PLUGIN_ID);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

// ---- 布置插件目录（不带 node_modules） ---------------------------------------
mkdirSync(plugDir, { recursive: true });
for (const f of ["manifest.json", "index.mjs"]) cpSync(join(SRC, f), join(plugDir, f));
mkdirSync(join(plugDir, "client"), { recursive: true });
cpSync(join(SRC, "client", "entry.mjs"), join(plugDir, "client", "entry.mjs"));
if (!existsSync(join(plugDir, "client", "entry.mjs"))) {
	fail("client/entry.mjs 缺失——请先在 plugins/db-client 下 npm run build");
	process.exit(1);
}

// ---- 用内置 node:sqlite 造测试库 -------------------------------------------
const dbFile = join(dataDir, "fixture.db");
{
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbFile);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER)");
	const ins = db.prepare("INSERT INTO users (name, age) VALUES (?, ?)");
	for (let i = 1; i <= 5; i++) ins.run(`user-${i}`, i * 7 + 10);
	db.close();
}

/** 连接 WS 并等 ready */
function connect(clientId = "dbclient-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId })));
		sock.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "ready") {
				clearTimeout(timer);
				resolve(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/** 发 plugin_message 并等匹配 reqId 的 plugin_data 响应 */
function rpc(sock, payload, timeoutMs = 20_000) {
	const reqId = `t${++seq}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting res for ${payload.action}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugin_data" && msg.pluginId === PLUGIN_ID && msg.payload?.res && msg.payload.reqId === reqId) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
		sock.send(JSON.stringify({ type: "plugin_message", pluginId: PLUGIN_ID, payload: { ...payload, reqId } }));
	});
}
let seq = 0;

/** 等事件消息 */
function waitEvent(sock, event, label, timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting event ${label}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugin_data" && msg.pluginId === PLUGIN_ID && msg.payload?.event === event) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg.payload);
			}
		};
		sock.on("message", onMsg);
	});
}

try {
	// 端口占用检查
	try {
		execFileSync("lsof", ["-ti", `:${PORT}`, "-sTCP:LISTEN"], { stdio: "pipe" });
		console.error(`✗ port ${PORT} busy — abort`);
		process.exit(1);
	} catch {
		/* free */
	}

	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_DB_CLIENT_NO_AUTOINSTALL: "1",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let serverLogs = "";
	proc.stderr?.on("data", (d) => {
		serverLogs += d.toString();
	});

	// 等 /api/health 就绪
	const deadline = Date.now() + 30_000;
	while (true) {
		try {
			const r = await fetch(`${BASE}/api/health`);
			if (r.ok) break;
		} catch {
			/* retry */
		}
		if (Date.now() > deadline) throw new Error("server not ready in 30s");
		await new Promise((r) => setTimeout(r, 300));
	}

	const sock = await connect();

	// 1. 插件清单推送
	const pluginsMsg = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout waiting plugins list")), 10_000);
		const onMsg = (raw) => {
			const m = JSON.parse(raw.toString());
			if (m.type === "plugins") {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m);
			}
		};
		sock.on("message", onMsg);
	});
	const info = pluginsMsg.plugins?.find((p) => p.id === PLUGIN_ID);
	if (!info) fail("插件清单缺少 db-client");
	else if (!info.hasClient) fail("db-client 未探测到客户端 bundle");

	// 2. state 初始为空 + 驱动可用性
	{
		const r = await rpc(sock, { action: "state" });
		if (!r.ok) fail(`state 失败：${r.error}`);
		if (!Array.isArray(r.state?.conns)) fail("state.conns 缺失");
		if (r.state.conns.length !== 0) fail("初始应有 0 个连接配置");
		if (r.state.depsAvail?.["node:sqlite"] !== true) fail("node:sqlite 应已可用");
		if (r.state.depsOk !== false) fail("只装部分驱动时 depsOk 应为 false");
		console.log("· state ok（depsAvail 按驱动粒度）");
	}

	// 3. conns_save（sqlite 无 host 也合法）
	{
		const r = await rpc(sock, { action: "conns_save", conn: { name: "测试库", type: "sqlite", file: dbFile } });
		if (!r.ok) fail(`conns_save 失败：${r.error}`);
		const s = await rpc(sock, { action: "state" });
		const c = s.state.conns[0];
		if (!c || c.type !== "sqlite" || !c.file) fail("保存后 state 里找不到连接配置");
		if ("password" in c) fail("回显不应携带 password 字段（脱敏）");
		globalThis.connCfgId = c.id;
		console.log("· conns_save ok（脱敏回显）");
	}

	// 4. test 动作（表单测试）
	{
		const r = await rpc(sock, { action: "test", conn: { type: "sqlite", file: dbFile } });
		if (!r.ok) fail(`test 失败：${r.error}`);
		console.log("· test ok");
	}

	// 5. connect
	let connId;
	{
		const r = await rpc(sock, { action: "connect", id: globalThis.connCfgId });
		if (!r.ok) fail(`connect 失败：${r.error}`);
		connId = r.connId;
		if (r.kind !== "sql") fail(`kind 应为 sql，实际 ${r.kind}`);
		console.log(`· connect ok（connId=${connId}）`);
	}

	// 6. tables_list
	{
		const r = await rpc(sock, { action: "tables_list", connId, db: "main" });
		if (!r.ok) fail(`tables_list 失败：${r.error}`);
		if (!r.tables.some((t) => t.name === "users" && t.kind === "table")) fail("users 表缺失");
		console.log("· tables_list ok");
	}

	// 7. describe
	{
		const r = await rpc(sock, { action: "describe", connId, db: "main", table: "users" });
		if (!r.ok) fail(`describe 失败：${r.error}`);
		const d = r.describe;
		if (d.columns.length !== 3) fail(`列数应为 3，实际 ${d.columns.length}`);
		if (!d.columns[0].key) fail("id 应标记为主键");
		if (!d.ddl?.includes("users")) fail("DDL 不应为空");
		console.log("· describe ok");
	}

	// 8. page 分页 + 排序
	{
		const r1 = await rpc(sock, { action: "page", connId, db: "main", table: "users", offset: 0, limit: 2 });
		if (!r1.ok) fail(`page 失败：${r1.error}`);
		if (r1.grid.total !== 5) fail(`total 应为 5，实际 ${r1.grid.total}`);
		if (r1.grid.rows.length !== 2) fail("本页应 2 行");
		if (r1.grid.columns.join(",") !== "id,name,age") fail(`columns 不符：${r1.grid.columns}`);
		const r2 = await rpc(sock, {
			action: "page",
			connId,
			db: "main",
			table: "users",
			offset: 0,
			limit: 2,
			orderBy: "id",
			dir: "desc",
		});
		if (Number(r2.grid.rows[0][0]) !== 5) fail("desc 排序首行 id 应为 5");
		console.log("· page 分页/排序 ok");
	}

	// 9. query_exec 成功与失败路径
	{
		const r = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "SELECT COUNT(*) AS n FROM users" });
		if (!r.ok) fail(`query_exec 失败：${r.error}`);
		if (r.grid.rows[0][0] !== 5) fail("COUNT(*) 应为 5");
		if (typeof r.grid.elapsedMs !== "number") fail("应返回耗时");
		const bad = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "SELEC oops" });
		if (bad.ok !== false || !bad.error) fail("坏 SQL 应返回 ok:false + error");
		console.log("· query_exec 成功/失败路径 ok");
	}

	// 9.5 行编辑：page 响应带 editable/pkCol → update / insert / delete 全链路
	{
		const pg = await rpc(sock, { action: "page", connId, db: "main", table: "users", offset: 0, limit: 2 });
		if (pg.ok && pg.grid.editable !== true) fail("sqlite page 应返回 editable:true");
		if (pg.ok && pg.grid.pkCol !== "id") fail(`pkCol 应为 id，实际 ${pg.grid.pkCol}`);

		const up = await rpc(sock, {
			action: "row_update",
			connId,
			db: "main",
			table: "users",
			pk: { col: "id", val: 1 },
			changes: { name: "edited-1" },
		});
		if (!up.ok) fail(`row_update 失败：${up.error}`);
		else if (up.affected !== 1) fail(`row_update affected 应为 1，实际 ${up.affected}`);
		const chk = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "SELECT name FROM users WHERE id=1" });
		if (chk.grid.rows?.[0]?.[0] !== "edited-1") fail("row_update 未生效");

		const ins = await rpc(sock, {
			action: "row_insert",
			connId,
			db: "main",
			table: "users",
			values: { name: "zzz", age: 99 },
		});
		if (!ins.ok) fail(`row_insert 失败：${ins.error}`);
		const cnt = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "SELECT COUNT(*) AS n FROM users" });
		if (cnt.grid.rows[0][0] !== 6) fail("插入后应为 6 行");

		const gid = await rpc(sock, {
			action: "query_exec",
			connId,
			db: "main",
			sql: "SELECT id FROM users WHERE name='zzz'",
		});
		const del = await rpc(sock, {
			action: "row_delete",
			connId,
			db: "main",
			table: "users",
			pk: { col: "id", val: gid.grid.rows[0][0] },
		});
		if (!del.ok || del.affected !== 1) fail(`row_delete 异常：${JSON.stringify(del)}`);
		const cnt2 = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "SELECT COUNT(*) AS n FROM users" });
		if (cnt2.grid.rows[0][0] !== 5) fail("删除后应回 5 行");

		const wipe = await rpc(sock, { action: "query_exec", connId, db: "main", sql: "DELETE FROM users" });
		if (!wipe.ok || wipe.grid.affected !== 5) fail(`写语句应生效（affected=5），实际 ${JSON.stringify(wipe)}`);
		console.log("· 行编辑 update/insert/delete + 写语句 ok");
	}

	// 10. disconnect → conn_closed 事件
	{
		const evP = waitEvent(sock, "conn_closed", "conn_closed");
		const r = await rpc(sock, { action: "disconnect", connId });
		if (!r.ok) fail(`disconnect 失败：${r.error}`);
		await evP;
		console.log("· disconnect + conn_closed 事件 ok");
	}

	// 11. 已删连接的 connect 报错；重连正常
	{
		const again = await rpc(sock, { action: "connect", id: globalThis.connCfgId });
		if (!again.ok) fail("重连失败");
		const ghost = await rpc(sock, { action: "connect", id: "nonexistent" });
		if (ghost.ok !== false) fail("不存在连接应报错");
		console.log("· 重连/未知连接报错 ok");
	}

	// 12. 静态服务：client bundle 可访问且不含服务端代码
	{
		const resp = await fetch(`${BASE}/plugins/${PLUGIN_ID}/client/entry.mjs`);
		const text = await resp.text();
		if (resp.status !== 200) fail(`entry.mjs 状态码 ${resp.status}`);
		if (!text.includes("dbx")) fail("entry.mjs 内容不符");
		const traversal = await fetch(`${BASE}/plugins/${PLUGIN_ID}/client/..%2f..%2findex.mjs`);
		if (traversal.status === 200) fail("路径穿越未被拦截");
		console.log("· 静态服务/穿越拦截 ok");
	}

	// 13. conns_delete 清理
	{
		const r = await rpc(sock, { action: "conns_delete", id: globalThis.connCfgId });
		if (!r.ok) fail(`conns_delete 失败：${r.error}`);
		const evP = waitEvent(sock, "conn_closed", "conn_closed(删除)").catch(() => null);
		await evP;
		const s = await rpc(sock, { action: "state" });
		if (s.state.conns.length !== 0) fail("删除后应为空列表");
		if (s.state.active.length !== 0) fail("删除后运行中连接应被清理");
		console.log("· conns_delete 级联断开 ok");
	}

	sock.close();
	if (process.exitCode !== 1) console.log("\n✓ db-client-test 全部通过");
} catch (err) {
	fail(err?.stack ?? err);
	if (serverLogs) console.error("---- server stderr ----\n" + serverLogs.slice(-3000));
} finally {
	if (proc) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {
			/* ignore */
		}
		// 等端口释放
		for (let i = 0; i < 40; i++) {
			await new Promise((r) => setTimeout(r, 250));
			try {
				execFileSync("lsof", ["-ti", `:${PORT}`, "-sTCP:LISTEN"], { stdio: "pipe" });
			} catch {
				break;
			}
		}
	}
	rmSync(dataDir, { recursive: true, force: true });
}
