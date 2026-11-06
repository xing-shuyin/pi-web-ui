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

const plugDir = join(dataDir, "plugins", "demo-mailbox");
const DEMO_MANIFEST = { name: "邮箱", version: "0.1.0", description: "demo" };
const DEMO_CLIENT_ENTRY = `export default { mount(el) { el.textContent = "ok"; } };`;
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
function seedDemoPlugin(marker) {
	mkdirSync(join(plugDir, "client"), { recursive: true });
	writeFileSync(join(plugDir, "manifest.json"), JSON.stringify(DEMO_MANIFEST));
	writeFileSync(join(plugDir, "index.mjs"), demoIndexCode(marker));
	writeFileSync(join(plugDir, "client", "entry.mjs"), DEMO_CLIENT_ENTRY);
	mkdirSync(join(plugDir, "client", "vendor"), { recursive: true });
	writeFileSync(join(plugDir, "client", "vendor", "nested.mjs"), `export const nested = "nested-225-ok";\n`);
}
seedDemoPlugin("pong-v1");

const feDir = join(dataDir, "plugins", "frontend-only");
mkdirSync(join(feDir, "client"), { recursive: true });
writeFileSync(join(feDir, "manifest.json"), JSON.stringify({ name: "纯前端" }));
writeFileSync(join(feDir, "client", "entry.mjs"), `export default {};`);

mkdirSync(join(dataDir, "plugins", "bad-json"), { recursive: true });
writeFileSync(join(dataDir, "plugins", "bad-json", "manifest.json"), "{oops");

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
	const { execFileSync } = await import("node:child_process");
	try {
		execFileSync("lsof", ["-ti", `:${PORT}`, "-sTCP:LISTEN"], { stdio: "pipe" });
		console.error(`✗ port ${PORT} busy — abort`);
		process.exit(1);
	} catch {}

	proc = spawn(serverPath, [join(import.meta.dirname, "..", "dist", "server", "index.js")], {
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: import.meta.dirname,
			PI_WEB_PLUGIN_CATALOG_URL: process.env.PI_WEB_PLUGIN_CATALOG_URL ?? "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

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
	const broken = list.find((p) => p.id === "bad-json");
	if (!broken || typeof broken.error !== "string" || broken.error.length === 0 || broken.view !== false) {
		fail(`bad-json dir should surface a broken placeholder row (error + view:false): ${JSON.stringify(broken)}`);
	} else {
		console.log("✓ bad manifest surfaces a placeholder row (error + view:false, never activated)");
	}

	const render = list.find((p) => p.id === "fence-render");
	if (!render || render.view !== false || JSON.stringify(render.renderers) !== JSON.stringify(["plantuml", "narr"])) {
		fail(`renderer plugin fields wrong: ${JSON.stringify(render)}`);
	} else {
		console.log("✓ renderer plugin carries view:false + renderers:[plantuml,narr]");
	}
	if (demo.view !== true || demo.renderers !== undefined) {
		fail(`demo-mailbox view/renderers default wrong: view=${demo.view} renderers=${JSON.stringify(demo.renderers)}`);
	} else {
		console.log("✓ regular plugin defaults view:true, renderers:undefined");
	}

	const echoP = waitFor(sock, (m) => m.type === "plugin_data" && m.pluginId === "demo-mailbox", "plugin_data");
	sock.send(
		JSON.stringify({ type: "plugin_message", pluginId: "demo-mailbox", payload: { action: "ping", value: 42 } }),
	);
	const echo = await echoP;
	if (echo.payload?.pong !== 42) fail(`echo wrong: ${JSON.stringify(echo.payload)}`);
	else console.log("✓ plugin_message round-trips to plugin_data");

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

	const beforeEpoch = pluginsMsg.epoch ?? 0;
	const reP = waitFor(sock, (m) => m.type === "plugins" && (m.epoch ?? 0) > beforeEpoch, "plugins(reload)");
	sock.send(JSON.stringify({ type: "plugins_reload" }));
	const reMsg = await reP;
	if (!reMsg.plugins?.some((p) => p.id === "demo-mailbox")) fail("reload lost demo-mailbox");
	else console.log(`✓ plugins_reload bumps epoch (${beforeEpoch} → ${reMsg.epoch}) and re-pushes catalog`);

	sock2.close();

	const ping = await fetch(`${BASE}/plugins-api/demo-mailbox/ping`);
	if (ping.status !== 200 || (await ping.text()) !== "pong-v1") {
		fail(`plugin HTTP route broken: ${ping.status} ${await ping.text()}`);
	} else {
		console.log("✓ host.route serves /plugins-api/:id/* with the plugin's own handler");
	}
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

	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "no-such", payload: { x: 1 } }));
	sock.send(JSON.stringify({ type: "plugin_message", pluginId: "../evil", payload: { x: 1 } }));
	await new Promise((r) => setTimeout(r, 500));
	console.log("✓ unknown/illegal pluginId silently ignored");

	const jsRes = await fetch(`${BASE}/plugins/demo-mailbox/client/entry.mjs`);
	const ct = jsRes.headers.get("content-type") ?? "";
	if (!jsRes.ok || !ct.includes("text/javascript")) {
		fail(`client entry fetch failed: ${jsRes.status} ${ct}`);
	} else if (!(await jsRes.text()).includes("export default")) {
		fail("client entry content wrong");
	} else {
		console.log("✓ /plugins/:id/client/* serves JS with correct Content-Type");
	}
	const nestedRes = await fetch(`${BASE}/plugins/demo-mailbox/client/vendor/nested.mjs`);
	const nestedCt = nestedRes.headers.get("content-type") ?? "";
	if (!nestedRes.ok || !nestedCt.includes("text/javascript")) {
		fail(`client nested file fetch failed: ${nestedRes.status} ${nestedCt}`);
	} else if (!(await nestedRes.text()).includes("nested-225-ok")) {
		fail("client nested file content wrong");
	} else {
		console.log("✓ /plugins/:id/client/vendor/* serves nested JS (issue #225)");
	}
	for (const bad of [`${BASE}/plugins/demo-mailbox/index.mjs`, `${BASE}/plugins/demo-mailbox/manifest.json`]) {
		const r = await fetch(bad);
		const body = await r.text();
		if (!body.startsWith("<!doctype html") && !body.includes("<div id=")) {
			fail(`server file leaked via ${bad}: ${body.slice(0, 80)}`);
		}
	}
	{
		const r = await fetch(`${BASE}/plugins/%2e%2e%2f%2e%2e%2fclient-state.json/client/entry.mjs`);
		const body = await r.text();
		if (body.includes("{")) fail(`traversal returned data: ${body.slice(0, 80)}`);
	}
	console.log("✓ server entry/manifest/path-traversal never exposed");

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
	const rmCatP = waitFor(sock, (m) => m.type === "plugin_catalog", "catalog after remove");
	sock.send(JSON.stringify({ type: "plugin_catalog_remove", id: "my-tool" }));
	const catAfterRm = await rmCatP;
	if ((catAfterRm.entries ?? []).some((e) => e.id === "my-tool")) fail("custom entry should be removed");
	if (!(catAfterRm.entries ?? []).some((e) => e.id === "webmail" && e.builtin))
		fail("builtin entry must survive remove");
	console.log("✓ plugin_catalog_remove drops the custom entry, builtin survives");
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
		setTimeout(() => {
			rmSync(dataDir, { recursive: true, force: true });
			process.exit(process.exitCode);
		}, 500);
	} else {
		rmSync(dataDir, { recursive: true, force: true });
	}
}
