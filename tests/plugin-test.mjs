/**
 * 插件机制协议冒烟测试（零 token、自包含）。
 *
 * 覆盖：
 * - attach 后推送 plugins 目录清单（manifest 解析 + hasClient 探测）
 * - plugin_message → 服务端入口 onMessage → broadcast → plugin_data 回环
 * - /plugins/<id>/client/* 静态服务（Content-Type、路径穿越拒绝）
 * - 未激活插件的 plugin_message 静默丢弃（不崩、无回声）
 * - 坏 manifest / 非 id 目录被扫描跳过
 *
 * 运行：先 npm run build:server，再 node tests/plugin-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const PORT = 8978;
const BASE = `http://127.0.0.1:${PORT}`;

const serverPath = realpathSync(process.execPath);
let proc = null;
let ws = null;
const dataDir = mkdtempSync(join(tmpdir(), "pi-web-plugin-test-"));

// ---- 种插件目录 ------------------------------------------------------------
// 1) 正常插件：服务端入口 + 客户端 bundle
const plugDir = join(dataDir, "plugins", "demo-mailbox");
const DEMO_MANIFEST = { name: "邮箱", version: "0.1.0", description: "demo" };
const DEMO_CLIENT_ENTRY = `export default { mount(el) { el.textContent = "ok"; } };`;
/** demo 插件的服务端入口。marker = host.route 的响应体（重新激活后应换成磁盘上的新值）。 */
function demoIndexCode(marker) {
	return `export default {
		activate(host) {
			const offRoute = host.route("GET", "/ping", (req, res) => res.end(${JSON.stringify(marker)}));
			const offMsg = host.onMessage((payload) => {
				if (payload && payload.action === "ping") host.broadcast({ pong: payload.value });
				else if (payload && payload.action === "notify") host.notify("info", String(payload.text ?? "插件通知测试"));
				else if (payload && payload.action === "echo-to") host.sendTo(String(payload.clientId), { direct: payload.direct });
			});
			return () => { offRoute(); offMsg(); };
		},
	};`;
}
/** 落一份完整的 demo 插件目录（模拟 `pi-web-ui install`：manifest + 服务端入口 + client bundle）。 */
function seedDemoPlugin(marker) {
	mkdirSync(join(plugDir, "client"), { recursive: true });
	writeFileSync(join(plugDir, "manifest.json"), JSON.stringify(DEMO_MANIFEST));
	writeFileSync(join(plugDir, "index.mjs"), demoIndexCode(marker));
	writeFileSync(join(plugDir, "client", "entry.mjs"), DEMO_CLIENT_ENTRY);
}
seedDemoPlugin("pong-v1");

// 2) 纯前端插件（无 index.mjs，只有视图 bundle）
const feDir = join(dataDir, "plugins", "frontend-only");
mkdirSync(join(feDir, "client"), { recursive: true });
writeFileSync(join(feDir, "manifest.json"), JSON.stringify({ name: "纯前端" }));
writeFileSync(join(feDir, "client", "entry.mjs"), `export default {};`);

// 3) 坏 manifest（应被扫描跳过）
mkdirSync(join(dataDir, "plugins", "bad-json"), { recursive: true });
writeFileSync(join(dataDir, "plugins", "bad-json", "manifest.json"), "{oops");

// 4) renderer 插件：view:false + renderers（fenced-code 渲染插件机制）
const renderDir = join(dataDir, "plugins", "fence-render");
mkdirSync(join(renderDir, "client"), { recursive: true });
writeFileSync(
	join(renderDir, "manifest.json"),
	JSON.stringify({ name: "Fence 渲染", view: false, renderers: ["plantuml", "narr"] }),
);
writeFileSync(join(renderDir, "client", "entry.mjs"), `export default { renderers: { plantuml: async () => null } };`);

function fail(msg) {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
}

/** 连接 WS 并等第一条 plugins 消息。 */
function connect(clientId = "plugin-test") {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 15_000);
		sock.on("open", () => {
			sock.send(JSON.stringify({ type: "hello", clientId }));
		});
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

/** 等到匹配谓词的 server 消息（带超时）。 */
function waitFor(sock, pred, label, timeoutMs = 8000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), timeoutMs);
		const onMsg = (raw) => {
			const msg = JSON.parse(raw.toString());
			if (pred(msg)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(msg);
			}
		};
		sock.on("message", onMsg);
	});
}

try {
	// 端口占用检查
	const { execFileSync } = await import("node:child_process");
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
			PI_WEB_CWD: import.meta.dirname,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

	// 等 HTTP 就绪
	await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const probe = async () => {
			try {
				const r = await fetch(`${BASE}/api/health`);
				if (r.ok) return resolve();
			} catch {}
			if (Date.now() - t0 > 20_000) return reject(new Error("server not ready"));
			setTimeout(probe, 300);
		};
		void probe();
	});

	// -- 1. attach → plugins 清单 ------------------------------------------
	let sock = await connect();
	const pluginsMsg = await waitFor(sock, (m) => m.type === "plugins", "plugins");
	const list = pluginsMsg.plugins ?? [];
	const demo = list.find((p) => p.id === "demo-mailbox");
	if (!demo || demo.name !== "邮箱" || demo.version !== "0.1.0") {
		fail(`demo-mailbox not listed correctly: ${JSON.stringify(demo)}`);
	} else if (demo.hasClient !== true || demo.error !== undefined) {
		fail(`demo-mailbox flags wrong: hasClient=${demo.hasClient} error=${demo.error}`);
	} else {
		console.log("✓ plugins list includes demo-mailbox with client entry");
	}
	if (!list.some((p) => p.id === "frontend-only" && p.hasClient === true)) {
		fail(`frontend-only missing or hasClient wrong: ${JSON.stringify(list)}`);
	} else {
		console.log("✓ frontend-only plugin detected (client entry, no server code)");
	}
	if (list.some((p) => p.id === "bad-json")) fail("bad-json dir should be skipped");
	else console.log("✓ bad manifest skipped");

	// -- 1b. renderer 插件（view/renderers 字段） ---------------------------
	const render = list.find((p) => p.id === "fence-render");
	if (!render || render.view !== false || JSON.stringify(render.renderers) !== JSON.stringify(["plantuml", "narr"])) {
		fail(`renderer plugin fields wrong: ${JSON.stringify(render)}`);
	} else {
		console.log("✓ renderer plugin carries view:false + renderers:[plantuml,narr]");
	}
	// 普通插件 view 缺省为 true
	if (demo.view !== true || demo.renderers !== undefined) {
		fail(`demo-mailbox view/renderers default wrong: view=${demo.view} renderers=${JSON.stringify(demo.renderers)}`);
	} else {
		console.log("✓ regular plugin defaults view:true, renderers:undefined");
	}

	// -- 2. plugin_message 回环 --------------------------------------------
	const echoP = waitFor(sock, (m) => m.type === "plugin_data" && m.pluginId === "demo-mailbox", "plugin_data");
	sock.send(
		JSON.stringify({ type: "plugin_message", pluginId: "demo-mailbox", payload: { action: "ping", value: 42 } }),
	);
	const echo = await echoP;
	if (echo.payload?.pong !== 42) fail(`echo wrong: ${JSON.stringify(echo.payload)}`);
	else console.log("✓ plugin_message round-trips to plugin_data");

	// -- 2b. host.notify → 系统通知条 ----------------------------------------
	const noticeP = waitFor(sock, (m) => m.type === "notice" && m.text?.includes("插件通知测试"), "notice");
	sock.send(
		JSON.stringify({
			type: "plugin_message",
			pluginId: "demo-mailbox",
			payload: { action: "notify", text: "插件通知测试 OK" },
		}),
	);
	await noticeP;
	console.log("✓ host.notify delivers a system notice");

	// -- 2c. host.sendTo 定向投递（双 socket） --------------------------------
	const sock2 = await connect("plug-b");
	const toB = waitFor(sock2, (m) => m.type === "plugin_data" && m.payload?.direct === "b", "direct-to-b");
	let leaked = false;
	const leakWatch = (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.type === "plugin_data" && m.payload?.direct === "b") leaked = true;
	};
	sock.on("message", leakWatch);
	sock.send(
		JSON.stringify({
			type: "plugin_message",
			pluginId: "demo-mailbox",
			payload: { action: "echo-to", clientId: "plug-b", direct: "b" },
		}),
	);
	await toB;
	await new Promise((r) => setTimeout(r, 300));
	sock.off("message", leakWatch);
	if (leaked) fail("sendTo message leaked to the other socket");
	else console.log("✓ host.sendTo targets only the addressed socket");

	// -- 2e. 设置面板插件开关：set_settings 回显 + 持久化 ---------------------
	const disP = waitFor(
		sock,
		(m) => m.type === "settings_state" && m.settings?.disabledPlugins?.includes("demo-mailbox"),
		"settings_state(disabled)",
	);
	sock.send(JSON.stringify({ type: "set_settings", disabledPlugins: ["demo-mailbox"] }));
	await disP;
	const enP = waitFor(
		sock,
		(m) => m.type === "settings_state" && !(m.settings?.disabledPlugins ?? []).includes("demo-mailbox"),
		"settings_state(re-enabled)",
	);
	sock.send(JSON.stringify({ type: "set_settings", disabledPlugins: [] }));
	await enP;
	console.log("✓ set_settings echoes disabledPlugins toggle");

	// -- 2d. plugins_reload：epoch 递增 + 清单重推 ----------------------------
	const beforeEpoch = pluginsMsg.epoch ?? 0;
	const reP = waitFor(sock, (m) => m.type === "plugins" && (m.epoch ?? 0) > beforeEpoch, "plugins(reload)");
	sock.send(JSON.stringify({ type: "plugins_reload" }));
	const reMsg = await reP;
	if (!reMsg.plugins?.some((p) => p.id === "demo-mailbox")) fail("reload lost demo-mailbox");
	else console.log(`✓ plugins_reload bumps epoch (${beforeEpoch} → ${reMsg.epoch}) and re-pushes catalog`);

	sock2.close();

	// -- 2f. 插件 HTTP 路由（install --force 的 rm→cp 窗口后必须能自愈） -------
	// 背景：CLI 装插件是先删目录再拷文件；扫描撞上窗口期会把插件反激活，目录回来后
	// 若不能重新激活，插件的 /proxy 等路由就永久消失（前端只看到「代理请求失败 404」）。
	const ping = await fetch(`${BASE}/plugins-api/demo-mailbox/ping`);
	if (ping.status !== 200 || (await ping.text()) !== "pong-v1") {
		fail(`plugin HTTP route broken: ${ping.status} ${await ping.text()}`);
	} else {
		console.log("✓ host.route serves /plugins-api/:id/* with the plugin's own handler");
	}
	// 安装窗口期：目录暂时不在 → 另一次 attach 触发的扫描视作卸载
	rmSync(plugDir, { recursive: true, force: true });
	const sockGone = await connect("plug-gone");
	await waitFor(
		sockGone,
		(m) => m.type === "plugins" && !(m.plugins ?? []).some((p) => p.id === "demo-mailbox"),
		"plugins(after rm)",
	);
	sockGone.close();
	{
		const r = await fetch(`${BASE}/plugins-api/demo-mailbox/ping`);
		if (r.status !== 404) fail(`deactivated plugin route should 404, got ${r.status}`);
	}
	// 安装完成：目录带着新代码回来 → 下一次 attach 必须重新激活并拿到新代码
	seedDemoPlugin("pong-v2");
	const sockBack = await connect("plug-back");
	const backMsg = await waitFor(
		sockBack,
		(m) => m.type === "plugins" && (m.plugins ?? []).some((p) => p.id === "demo-mailbox"),
		"plugins(after restore)",
	);
	if (backMsg.plugins.find((p) => p.id === "demo-mailbox")?.error) {
		fail(`reactivation failed: ${backMsg.plugins.find((p) => p.id === "demo-mailbox").error}`);
	}
	sockBack.close();
	const ping2 = await fetch(`${BASE}/plugins-api/demo-mailbox/ping`);
	if (ping2.status !== 200 || (await ping2.text()) !== "pong-v2") {
		fail(`plugin not reactivated after dir came back: ${ping2.status} ${await ping2.text()}`);
	} else {
		console.log("✓ plugin reactivates with fresh code after the install window (no server restart)");
	}

	// -- 3. 未知/未激活插件的静默丢弃 --------------------------------------
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "no-such", payload: { x: 1 } }));
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "../evil", payload: { x: 1 } }));
	await new Promise((r) => setTimeout(r, 500)); // 若崩溃，下面的请求会失败
	console.log("✓ unknown/illegal pluginId silently ignored");

	// -- 4. 客户端静态服务 --------------------------------------------------
	const jsRes = await fetch(`${BASE}/plugins/demo-mailbox/client/entry.mjs`);
	const ct = jsRes.headers.get("content-type") ?? "";
	if (!jsRes.ok || !ct.includes("text/javascript")) {
		fail(`client entry fetch failed: ${jsRes.status} ${ct}`);
	} else if (!(await jsRes.text()).includes("export default")) {
		fail("client entry content wrong");
	} else {
		console.log("✓ /plugins/:id/client/* serves JS with correct Content-Type");
	}
	// 服务端代码与 manifest 不在 client/ 白名单里 —— 路由不匹配时落到 SPA
	// catch-all 返回 index.html（200 但是 HTML），绝不能返回文件本体。
	for (const bad of [`${BASE}/plugins/demo-mailbox/index.mjs`, `${BASE}/plugins/demo-mailbox/manifest.json`]) {
		const r = await fetch(bad);
		const body = await r.text();
		if (!body.startsWith("<!doctype html") && !body.includes("<div id=")) {
			fail(`server file leaked via ${bad}: ${body.slice(0, 80)}`);
		}
	}
	{
		// 路径穿越：id 段非法，同样只能落 SPA 兑底
		const r = await fetch(`${BASE}/plugins/%2e%2e%2f%2e%2e%2fclient-state.json/client/entry.mjs`);
		const body = await r.text();
		if (body.includes("{")) fail(`traversal returned data: ${body.slice(0, 80)}`);
	}
	console.log("✓ server entry/manifest/path-traversal never exposed");

	// -- 5. 插件市场列表（plugin_catalog）：添加/移除回环 + 内置条目 -----------
	// 注：attach 时的 plugin_catalog 在 connect()（ready）后已到达，此处监听新推送。
	const addNoticeP = waitFor(sock, (m) => m.type === "notice" && m.text?.includes("已添加到插件列表"), "add notice");
	const addCatP = waitFor(sock, (m) => m.type === "plugin_catalog", "catalog after add");
	sock.send(
		JSON.stringify({
			type: "plugin_catalog_add",
			entry: { source: "someone/else/tool", id: "my-tool", name: "我的插件" },
		}),
	);
	const catAfterAdd = await addCatP;
	await addNoticeP;
	const entries = catAfterAdd.entries ?? [];
	// 随包 catalog.json 里有内置维护条目（webmail/db-client/vscode-editor/mermaid）
	if (!entries.some((e) => e.id === "webmail" && e.builtin === true && e.source) || entries.length < 4) {
		fail(`builtin catalog wrong: ${JSON.stringify(entries)}`);
	} else {
		console.log(
			`✓ plugin_catalog carries ${entries.filter((e) => e.builtin).length} builtin + ${entries.filter((e) => !e.builtin).length} custom entries`,
		);
	}
	const added = entries.find((e) => e.id === "my-tool");
	if (!added || added.builtin !== false || added.name !== "我的插件" || added.source !== "someone/else/tool") {
		fail(`custom entry not merged: ${JSON.stringify(added)}`);
	} else {
		console.log("✓ plugin_catalog_add persists custom entry + re-pushes");
	}
	// 移除自定义条目 → 重推后消失（builtin 仍在）
	const rmCatP = waitFor(sock, (m) => m.type === "plugin_catalog", "catalog after remove");
	sock.send(JSON.stringify({ type: "plugin_catalog_remove", id: "my-tool" }));
	const catAfterRm = await rmCatP;
	if ((catAfterRm.entries ?? []).some((e) => e.id === "my-tool")) fail("custom entry should be removed");
	if (!(catAfterRm.entries ?? []).some((e) => e.id === "webmail" && e.builtin))
		fail("builtin entry must survive remove");
	console.log("✓ plugin_catalog_remove drops the custom entry, builtin survives");
	// 自定义文件落盘校验
	{
		const { readFileSync } = await import("node:fs");
		const stored = JSON.parse(readFileSync(join(dataDir, "plugin-catalog.json"), "utf8"));
		if ((stored.entries ?? []).length !== 0) fail(`custom file should be back to empty: ${JSON.stringify(stored)}`);
		console.log("✓ <dataDir>/plugin-catalog.json persisted");
	}

	sock.close();
	console.log("\nALL PLUGIN TESTS PASSED");
} catch (err) {
	console.error("✗ test failed:", err);
	process.exitCode = 1;
} finally {
	ws?.close();
	proc?.kill("SIGTERM");
	if (process.exitCode) {
		// 给非零退出前留出清理时间，但不要悬挂
		setTimeout(() => {
			rmSync(dataDir, { recursive: true, force: true });
			process.exit(process.exitCode);
		}, 500);
	} else {
		rmSync(dataDir, { recursive: true, force: true });
	}
}
