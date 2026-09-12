/**
 * 插件 HTTP 路由协议测试（零 token、自包含）。
 *
 * host.route("GET"/"POST", path, handler) 实际暴露为 /plugins-api/<id><path>：
 * 覆盖 GET/POST 命中、未知插件 404、未注册路径 404、handler 抛错 500、
 * 注销后路由消失。
 *
 * 运行：先 npm run build:server，再 node tests/plugin-http-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8981;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-http-plugin-"));

const plugDir = join(dataDir, "plugins", "api");
mkdirSync(plugDir, { recursive: true });
writeFileSync(join(plugDir, "manifest.json"), JSON.stringify({ name: "api", version: "0.1.0" }));
writeFileSync(
	join(plugDir, "index.mjs"),
	`export default {
	activate(host) {
		host.route("GET", "/ping", (req, res) => {
			res.type("application/json").send({ pong: true, q: req.query?.echo ?? "" });
		});
		host.route("POST", "/submit", (req, res) => {
			res.json({ got: req.body ?? null });
		});
		const off = host.route("GET", "/gone", (_req, res) => res.send("bye"));
		off(); // 注册即注销 → 应 404
		host.route("GET", "/boom", () => { throw new Error("炸了"); });
		// 异步 handler 的 rejection：宿主必须也能接住（只 try/catch 同步抛错的话，
		// 这里会变成 unhandledRejection 把整个服务打挂）
		host.route("GET", "/boom-async", async () => { throw new Error("异步炸了"); });
	},
};`,
);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

async function connectWs() {
	return new Promise((resolve2, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "http-test" })));
		sock.on("message", (raw) => {
			if (JSON.parse(raw.toString()).type === "ready") {
				clearTimeout(timer);
				resolve2(sock);
			}
		});
		sock.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

try {
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	await new Promise((resolve2, reject) => {
		const t0 = Date.now();
		const ping = async () => {
			try {
				if ((await fetch(`${BASE}/api/health`)).ok) return resolve2();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(ping, 300);
		};
		void ping();
	});

	// WS attach 触发插件激活（路由随之挂载）
	const sock = await connectWs();
	await new Promise((r) => setTimeout(r, 800));

	// -- GET 命中 + query ------------------------------------------------------
	let r = await fetch(`${BASE}/plugins-api/api/ping?echo=hi`);
	if (r.status !== 200 || (await r.json()).pong !== true) fail(`GET /ping 异常：${r.status}`);
	else console.log('✓ GET /plugins-api/api/ping → {"pong":true}');

	// -- POST + express.json body ---------------------------------------------
	r = await fetch(`${BASE}/plugins-api/api/submit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ x: 42 }),
	});
	if (r.status !== 200 || (await r.json()).got?.x !== 42) fail(`POST /submit 异常：${r.status}`);
	else console.log("✓ POST body 解析并透传 handler");

	// -- 未注册路径 404 / 注销后的路由 404 --------------------------------------
	r = await fetch(`${BASE}/plugins-api/api/nope`);
	if (r.status !== 404) fail(`未注册路径应 404，实际 ${r.status}`);
	r = await fetch(`${BASE}/plugins-api/api/gone`);
	if (r.status !== 404) fail(`注销后的路由应 404，实际 ${r.status}`);
	console.log("✓ 未注册/已注销路由 → 404");

	// -- 未知插件 404 / handler 抛错 500 ----------------------------------------
	r = await fetch(`${BASE}/plugins-api/nosuch/ping`);
	if (r.status !== 404) fail(`未知插件应 404，实际 ${r.status}`);
	r = await fetch(`${BASE}/plugins-api/api/boom`);
	if (r.status !== 500) fail(`handler 抛错应 500，实际 ${r.status}`);
	r = await fetch(`${BASE}/plugins-api/api/boom-async`);
	if (r.status !== 500) fail(`异步 handler 抛错应 500，实际 ${r.status}`);
	// 关键：进程必须还活着（旧实现会因 unhandledRejection 直接退出）
	const alive = await fetch(`${BASE}/api/health`)
		.then((x) => x.ok)
		.catch(() => false);
	if (!alive) fail("异步 handler 抛错后服务挂了（unhandledRejection 未被兜住）");
	console.log("✓ 未知插件 → 404；handler（同步/异步）抛错 → 500 且服务存活");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {}
	}
	await new Promise((r2) => setTimeout(r2, 600));
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
