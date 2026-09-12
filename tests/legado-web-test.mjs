/**
 * legado-web 插件协议测试（零 token、自包含）。
 *
 * 覆盖：
 * - 插件清单推送（有客户端视图 / 服务端入口）
 * - /plugins/<id>/client/app/* 内嵌前端静态托管（index.html + 相对资源）
 * - /plugins-api/legado-web/proxy：UTF-8 / GBK 解码、charset 驱动 URL 与 POST body 编码、
 *   书源自定义头透传、**浏览器头（含 cookie）不透传**、上游失败 → 502
 * - /plugins-api/legado-web/store：键列表 / 单键读写 / 版本信息 ?meta=1 / 非法键 400 / 缺键 400 / 落盘位置
 *   （落 <dataDir>/legado-web/，外加旧版插件目录 storage/ 的回退兼容）
 *
 * 运行：先 npm run build:server，再 node tests/legado-web-test.mjs
 */
import { spawn } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { freePort, portUp } from "./lib/port-utils.mjs";

const PORT = 8993;
const UPSTREAM_PORT = 8994;
const BASE = `http://127.0.0.1:${PORT}`;
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

const serverPath = realpathSync(process.execPath);
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-legado-"));
let proc = null;
let upstream = null;

// 把仓库里的插件目录拷进临时 data-dir（与 CLI install 同样的 filter：不带 node_modules）
const srcPlugin = join(import.meta.dirname, "..", "plugins", "legado-web");
const plugDir = join(dataDir, "plugins", "legado-web");
cpSync(srcPlugin, plugDir, {
	recursive: true,
	filter: (s) => !/(^|[\\/])(node_modules|storage)([\\/]|$)/.test(s),
});
if (!existsSync(join(plugDir, "client", "app", "index.html"))) {
	console.error("✗ 缺 client/app/index.html —— 先跑 node plugins/legado-web/build.mjs");
	process.exit(1);
}

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

/** 上游测试站：UTF-8 页 / GBK 页 / 回显请求（url、body hex、收到的头）。 */
function startUpstream() {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			const u = new URL(req.url ?? "/", UPSTREAM);
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				if (u.pathname === "/utf8") {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end("<html><body>中文 UTF-8 内容</body></html>");
					return;
				}
				if (u.pathname === "/gbk") {
					// <html><head><meta charset="gbk">… 中文（GBK 字节）
					const head = Buffer.from('<html><head><meta charset="gbk"></head><body>', "latin1");
					const tail = Buffer.from("</body></html>", "latin1");
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(Buffer.concat([head, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), tail]));
					return;
				}
				// 其余路径：回显
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				res.end(
					JSON.stringify({
						url: req.url,
						method: req.method,
						bodyHex: body.toString("hex"),
						cookie: req.headers.cookie ?? null,
						ua: req.headers["user-agent"] ?? null,
						referer: req.headers.referer ?? null,
						X_Custom: req.headers["x-custom"] ?? null,
					}),
				);
			});
		});
		server.listen(UPSTREAM_PORT, "127.0.0.1", () => resolve(server));
	});
}

async function connectWs() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
		sock.on("open", () => sock.send(JSON.stringify({ type: "hello", clientId: "legado-test" })));
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

async function waitReady() {
	for (let i = 0; i < 60; i++) {
		if (await portUp(PORT)) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

const proxy = (path, init) => fetch(`${BASE}/plugins-api/legado-web${path}`, init);
const target = (p) => encodeURIComponent(`${UPSTREAM}${p}`);

try {
	freePort(PORT);
	freePort(UPSTREAM_PORT);
	upstream = await startUpstream();
	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: import.meta.dirname },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
	if (!(await waitReady())) throw new Error("服务未就绪");

	// -- 1. 清单推送 -----------------------------------------------------------
	const sock = await connectWs();
	const plugins = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("没收到 plugins 清单")), 10_000);
		sock.on("message", (raw) => {
			const msg = JSON.parse(raw.toString());
			if (msg.type === "plugins") {
				clearTimeout(timer);
				resolve(msg.plugins ?? []);
			}
		});
	});
	const info = plugins.find((p) => p.id === "legado-web");
	if (!info) fail("清单里没有 legado-web");
	else if (!info.hasClient) fail("legado-web 缺 hasClient（client/entry.mjs 没被识别）");
	else console.log(`✓ 清单推送 legado-web（hasClient=${info.hasClient}, view=${info.view ?? true}）`);

	// -- 2. 内嵌前端静态托管 ----------------------------------------------------
	let r = await fetch(`${BASE}/plugins/legado-web/client/app/index.html`);
	let html = await r.text();
	if (r.status !== 200 || !/text\/html/.test(r.headers.get("content-type") ?? "")) fail(`index.html 异常：${r.status}`);
	else if (!/src="\.\/assets\//.test(html)) fail("index.html 的资源不是相对路径（base 配置丢了？）");
	else console.log("✓ /plugins/legado-web/client/app/index.html → 200 + 相对资源");

	const assetPath = /src="\.\/(assets\/[^"]+)"/.exec(html)?.[1];
	r = await fetch(`${BASE}/plugins/legado-web/client/app/${assetPath}`);
	if (r.status !== 200 || !/javascript/.test(r.headers.get("content-type") ?? ""))
		fail(`bundle 静态服务异常：${r.status} ${r.headers.get("content-type")}`);
	else console.log(`✓ 前端 bundle 静态托管（${assetPath.split("/").pop()}）`);

	// -- 3. 代理：UTF-8 --------------------------------------------------------
	r = await proxy(`/proxy?url=${target("/utf8")}`);
	let j = await r.json();
	if (r.status !== 200 || !j.body?.includes("中文 UTF-8 内容"))
		fail(`UTF-8 代理异常：${r.status} ${j.body?.slice(0, 80)}`);
	else console.log("✓ 代理 UTF-8 页面（跨域抓取 + 原文返回）");

	// -- 4. 代理：GBK（meta 声明） ---------------------------------------------
	r = await proxy(`/proxy?url=${target("/gbk")}`);
	j = await r.json();
	if (r.status !== 200 || !j.body?.includes("中文")) fail(`GBK 解码异常：${JSON.stringify(j).slice(0, 120)}`);
	else console.log("✓ 代理 GBK 页面（无三方依赖解码）");

	// -- 5. 代理：charset 驱动的 URL 编码（GBK 中文搜索词） ----------------------
	r = await proxy(`/proxy?url=${target(`/echo?q=中文`)}&charset=gbk`);
	j = await r.json();
	if (r.status !== 200 || !j.body?.includes("%D6%D0%CE%C4"))
		fail(`charset=gbk 的 URL 重编码失败：${j.body?.slice(0, 200)}`);
	else console.log("✓ charset=gbk → URL 中文按 GBK 百分号编码");

	// -- 6. 代理：charset 驱动的 POST body 编码 + 书源自定义头 -------------------
	r = await proxy(`/proxy?url=${target("/echo")}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ headers: { "X-Custom": "yes" }, body: "中文", charset: "gbk" }),
	});
	j = await r.json();
	let echoed = null;
	try {
		echoed = JSON.parse(j.body);
	} catch {
		/* 见下断言 */
	}
	if (r.status !== 200 || echoed?.bodyHex !== "d6d0cec4") fail(`POST body GBK 编码失败：${j.body?.slice(0, 200)}`);
	else if (echoed?.X_Custom !== "yes") fail("书源自定义头未透传");
	else console.log("✓ charset=gbk → POST body 按 GBK 编码，自定义头透传");

	// -- 7. 安全：浏览器头（含 pi-web cookie）绝不透传给第三方 -------------------
	r = await proxy(`/proxy?url=${target("/echo")}`, {
		headers: { cookie: "pi_web_token=secret", referer: "http://127.0.0.1/pi/" },
	});
	j = await r.json();
	echoed = JSON.parse(j.body);
	if (echoed?.cookie !== null || echoed?.referer !== null) fail(`浏览器头被透传了：${j.body.slice(0, 200)}`);
	else if (!echoed?.ua) fail("缺少默认 UA");
	else console.log("✓ 浏览器 cookie/referer 不透传（只带默认 UA + 书源声明的头）");

	// -- 8. 代理：上游不可达 → 502 + 具体原因 -----------------------------------
	r = await proxy(`/proxy?url=${encodeURIComponent("http://127.0.0.1:9/nope")}`);
	j = await r.json().catch(() => ({}));
	if (r.status !== 502 || !j.error) fail(`上游失败应 502 带 error，实际 ${r.status}`);
	else console.log("✓ 上游不可达 → 502 + 原因");

	// -- 9. 存储：空 → 写 → 读 → 落盘 ------------------------------------------
	const storeBase = `${BASE}/plugins-api/legado-web/store`;
	r = await fetch(storeBase);
	j = await r.json();
	if (r.status !== 200 || !Array.isArray(j.keys)) fail(`GET /store 异常：${r.status}`);
	else console.log(`✓ GET /store → 键列表（初始 ${j.keys.length} 个）`);

	const payload = [{ bookSourceName: "测试源", bookSourceUrl: "http://example.com" }];
	r = await fetch(`${storeBase}?key=sources`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: payload }),
	});
	if (r.status !== 200 || !(await r.json()).ok) fail(`POST /store?key=sources 异常：${r.status}`);
	r = await fetch(`${storeBase}?key=sources`);
	j = await r.json();
	if (!j.value?.[0]?.bookSourceName) fail(`GET /store?key=sources 回读失败：${JSON.stringify(j).slice(0, 120)}`);

	const file = join(dataDir, "legado-web", "sources.json");
	if (!existsSync(file) || JSON.parse(readFileSync(file, "utf8"))[0].bookSourceUrl !== "http://example.com")
		fail(`落盘文件不对：${file}`);
	else console.log(`✓ 存储读写 + 落盘数据目录（${file.replace(dataDir, "<dataDir>")}）`);

	// 用户数据不放插件目录：install --force 会删掉插件目录，这里顺手验一下位置
	if (existsSync(join(plugDir, "storage"))) fail("存储又被写回插件目录了（更新插件会丢数据）");

	r = await fetch(storeBase);
	j = await r.json();
	if (!j.keys.includes("sources")) fail("键列表没包含刚写入的 sources");

	// -- 9b. 旧版插件目录 storage/ 的回退兼容 ------------------------------------
	mkdirSync(join(plugDir, "storage"), { recursive: true });
	writeFileSync(join(plugDir, "storage", "check.json"), JSON.stringify({ legacy: true }));
	r = await fetch(`${storeBase}?key=check`);
	j = await r.json();
	if (j.value?.legacy !== true) fail(`旧版 storage/ 回退读失败：${JSON.stringify(j).slice(0, 120)}`);
	else if (!existsSync(join(dataDir, "legado-web", "check.json"))) fail("旧数据没被搬到新数据目录");
	else console.log("✓ 旧版插件目录 storage/ 仍可读并自动搬入数据目录");

	// -- 9c. 存储：版本信息 ?meta=1（前端用它发现“数据目录被外部改过”） -----------------
	r = await fetch(`${storeBase}?meta=1`);
	j = await r.json();
	const meta = j.metas?.sources;
	const st = statSync(file);
	if (r.status !== 200 || !meta) fail(`GET /store?meta=1 异常：${r.status} ${JSON.stringify(j).slice(0, 120)}`);
	else if (meta.size !== st.size || Math.abs(meta.mtime - st.mtimeMs) > 2000)
		fail(`meta 与文件不一致：${JSON.stringify(meta)} vs ${st.size}/${st.mtimeMs}`);
	else console.log(`✓ GET /store?meta=1 → 各键 size+mtime（sources ${meta.size}B）`);

	const oldMtime = meta.mtime;
	await new Promise((r) => setTimeout(r, 1100)); // 等 mtime 走一格（秒级文件系统也够）
	writeFileSync(file, readFileSync(file, "utf8")); // 外部改文件：内容不变，只推 mtime
	r = await fetch(`${storeBase}?meta=1`);
	j = await r.json();
	if (!(j.metas?.sources?.mtime > oldMtime)) fail("外部改文件后 meta 没变（前端就发现不了改动）");
	else console.log("✓ 外部改写文件后 meta 变化（前端据此自动重读）");

	r = await fetch(`${storeBase}?key=progress`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: { "http://example.com/book": 3 } }),
	});
	j = await r.json();
	if (!j.meta?.size) fail(`POST /store 没回带 meta：${JSON.stringify(j).slice(0, 120)}`);
	else console.log("✓ POST /store 回带 meta（前端不会把自己的写入当成外部改动）");

	// -- 10. 存储：大 payload（真实书源列表常见几 MB，express.json 限制 10mb） ------
	const big = Array.from({ length: 4000 }, (_, i) => ({
		bookSourceName: `源${i}`,
		bookSourceUrl: `http://e${i}.com`,
		pad: "x".repeat(1200),
	}));
	r = await fetch(`${storeBase}?key=shelf`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: big }),
	});
	j = await r.json();
	if (r.status !== 200 || !j.ok) fail(`大 payload 写入失败：${r.status} ${JSON.stringify(j).slice(0, 120)}`);
	else console.log(`✓ 大 payload（${(j.bytes / 1024 / 1024).toFixed(1)} MB）写入正常`);

	// -- 11. 存储：非法键 / 缺键 ------------------------------------------------
	r = await fetch(`${storeBase}?key=../evil`);
	if (r.status !== 400) fail(`非法键应 400，实际 ${r.status}`);
	r = await fetch(storeBase, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value: 1 }),
	});
	if (r.status !== 400) fail(`缺 key 的 POST 应 400，实际 ${r.status}`);
	else console.log("✓ 非法键 / 缺键 → 400");

	sock.close();
} catch (err) {
	fail(err?.stack ?? String(err));
} finally {
	if (proc?.pid) {
		try {
			process.kill(proc.pid, "SIGTERM");
		} catch {
			/* 已退出 */
		}
	}
	upstream?.close();
	await new Promise((r2) => setTimeout(r2, 600));
	freePort(PORT);
	freePort(UPSTREAM_PORT);
	rmSync(dataDir, { recursive: true, force: true });
}
if (!process.exitCode) console.log("\nall ok");
