/**
 * 全局搜索（search_files / search_files_result）+ BgServer.command 协议冒烟。
 * 零 token：自起编译后的 server（隔离端口 8962 + 临时 data-dir），
 * 发 search_files 断言 reqId 回显与文件名匹配结果；空 query 返回空列表。
 */
import { portUp } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8962;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
}

// 临时工作区：带嵌套目录 + node_modules（应被忽略）
const workDir = join(mkdtempSync(join(tmpdir(), "pi-web-gs-test-")), "proj");
mkdirSync(join(workDir, "src"), { recursive: true });
mkdirSync(join(workDir, "node_modules", "somepkg"), { recursive: true });
writeFileSync(join(workDir, "README.md"), "hi");
writeFileSync(join(workDir, "src", "alpha-util.ts"), "export {};");
writeFileSync(join(workDir, "src", "beta.txt"), "x");
writeFileSync(join(workDir, "node_modules", "somepkg", "util.js"), "y");

const dataDir = mkdtempSync(join(tmpdir(), "pi-web-gs-data-"));
let server = null;

async function startServer() {
	server = spawn("node", ["dist/server/index.js"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workDir,
		},
		stdio: "ignore",
	});
	for (let i = 0; i < 40; i++) {
		await sleep(250);
		try {
			if (await portUp(PORT)) return;
		} catch {
			// not up yet
		}
	}
	throw new Error("server did not start");
}

function connect() {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(URL);
		const inbox = [];
		const waiters = [];
		const api = {
			ws,
			async next(pred, what, ms = 8000) {
				const existing = inbox.findIndex(pred);
				if (existing >= 0) return inbox.splice(existing, 1)[0];
				return new Promise((res, rej) => {
					const t = setTimeout(() => rej(new Error(`timeout waiting for ${what}`)), ms);
					waiters.push((m) => {
						if (pred(m)) {
							clearTimeout(t);
							res(m);
							return true;
						}
						return false;
					});
				});
			},
			send(m) {
				ws.send(JSON.stringify(m));
			},
		};
		ws.onopen = () => {
			api.send({ type: "hello", clientId: "gs-test" });
			resolve(api);
		};
		ws.onmessage = (ev) => {
			let msg;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			inbox.push(msg);
			for (let i = 0; i < waiters.length; i++) {
				if (waiters[i](msg)) {
					waiters.splice(i, 1);
					i--;
				}
			}
		};
		ws.onerror = reject;
	});
}

async function run() {
	await startServer();
	await sleep(300);
	const c = await connect();

	// 1) 文件搜索命中 + reqId 回显
	c.send({ type: "search_files", reqId: 42, query: "util" });
	const r1 = await c.next((m) => m.type === "search_files_result" && m.reqId === 42, "search_files_result #42");
	check("reqId 回显", r1.reqId === 42);
	check("ok:true", r1.ok === true, JSON.stringify(r1).slice(0, 200));
	const names = (r1.results ?? []).map((r) => r.name);
	check("命中 src/alpha-util.ts", names.includes("alpha-util.ts"), names.join(","));
	const utilHit = (r1.results ?? []).find((r) => r.name === "alpha-util.ts");
	check("相对路径为 src/alpha-util.ts", utilHit?.path === "src/alpha-util.ts", utilHit?.path);

	// 2) node_modules 被忽略
	c.send({ type: "search_files", reqId: 43, query: "somepkg" });
	const r2 = await c.next((m) => m.type === "search_files_result" && m.reqId === 43, "result #43");
	check("node_modules 不进结果", r2.ok && (r2.results ?? []).length === 0, JSON.stringify(r2.results));

	// 3) 目录也匹配
	c.send({ type: "search_files", reqId: 44, query: "src" });
	const r3 = await c.next((m) => m.type === "search_files_result" && m.reqId === 44, "result #44");
	check(
		"目录 src 命中且 type=dir",
		(r3.results ?? []).some((r) => r.name === "src" && r.type === "dir"),
		JSON.stringify(r3.results),
	);

	// 4) 空 query → 空列表，仍回显
	c.send({ type: "search_files", reqId: 45, query: "   " });
	const r4 = await c.next((m) => m.type === "search_files_result" && m.reqId === 45, "result #45");
	check("空 query 返回空列表", r4.ok && r4.results.length === 0);

	c.ws.close();
}

try {
	await run();
} catch (err) {
	console.error("FATAL:", err?.message ?? err);
	failures++;
} finally {
	if (server?.pid) process.kill(server.pid, "SIGTERM");
	await sleep(500);
}
process.exit(failures === 0 ? 0 : 1);
