import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 30000 + Math.floor(Math.random() * 10000);
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_ID = "pm2-manager";

const root = mkdtempSync(join(tmpdir(), "pi-pm2-manager-"));
const dataDir = join(root, "data");
const work = join(root, "work");
mkdirSync(work, { recursive: true });

const srcPlugin = resolve(__dirname, "../plugins", PLUGIN_ID);
const dstPlugin = join(dataDir, "plugins", PLUGIN_ID);
mkdirSync(dirname(dstPlugin), { recursive: true });
cpSync(srcPlugin, dstPlugin, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

let proc = null;
let sock = null;
let serverLog = "";
const messages = [];

const connect = (clientId) =>
	new Promise((resolve, reject) => {
		const s = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		const timer = setTimeout(() => reject(new Error("connect timeout")), 20_000);
		s.on("error", reject);
		s.on("open", () => s.send(JSON.stringify({ type: "hello", clientId })));
		s.on("message", (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			messages.push(m);
			if (m.type === "ready") {
				clearTimeout(timer);
				resolve(s);
			}
		});
	});

const waitMsg = (pred, label, timeoutMs = 20_000) => {
	const hit = messages.find(pred);
	if (hit) return Promise.resolve(hit);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			sock.off("message", onMsg);
			reject(new Error(`timeout waiting for ${label}`));
		}, timeoutMs);
		const onMsg = (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (pred(m)) {
				clearTimeout(timer);
				sock.off("message", onMsg);
				resolve(m);
			}
		};
		sock.on("message", onMsg);
	});
};

const postJson = async (path, body) => {
	const r = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, json: await r.json().catch(() => null) };
};

async function main() {
	proc = spawn(process.execPath, [resolve(__dirname, "../dist/server/index.js")], {
		env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_DATA_DIR: dataDir, PI_WEB_CWD: work },
		stdio: ["ignore", "pipe", "pipe"],
	});
	proc.stdout.on("data", (d) => {
		serverLog += String(d);
	});
	proc.stderr.on("data", (d) => {
		serverLog += String(d);
	});

	const t0 = Date.now();
	for (;;) {
		try {
			if ((await fetch(`${BASE}/api/health`)).ok) break;
		} catch {}
		if (Date.now() - t0 > 30_000) throw new Error("server not ready");
		await new Promise((r) => setTimeout(r, 300));
	}
	check("服务器起来了", true, `:${PORT}`);

	sock = await connect("pm2-manager-test");

	const pluginsMsg = await waitMsg((m) => m.type === "plugins", "plugins", 10_000).catch(() => null);
	const info = pluginsMsg?.plugins?.find((p) => p.id === PLUGIN_ID);
	check(
		"manifest 被接受且无激活错误",
		Boolean(info) && !info.error,
		info
			? `name=${info.name} hasClient=${info.hasClient}${info.error ? ` error=${info.error}` : ""}`
			: "未出现在 plugins 列表",
	);

	const panelItem = info?.ui?.items?.find((it) => it.slot === "tasks.panel");
	check("没有独立面板（view:false）", info?.view === false);
	check(
		"占住 tasks.panel 槽位（经 plugins 列表 UI 条目确认，协议目录消息已下线）",
		Boolean(panelItem) && panelItem.slot === "tasks.panel",
		JSON.stringify(panelItem ? { slot: panelItem.slot, kind: panelItem.kind } : null),
	);
	check(
		"槽位条目是 kind=view（面板内嵌渲染本插件）",
		panelItem?.kind === "view" && panelItem?.view === `plugin:${PLUGIN_ID}`,
		JSON.stringify(panelItem ? { kind: panelItem.kind, view: panelItem.view } : null),
	);

	const tWaitActivated = Date.now();
	while (!serverLog.includes("pm2-manager activated") && Date.now() - tWaitActivated < 5000) {
		await new Promise((r) => setTimeout(r, 100));
	}
	check("activate 跑完（日志可见）", serverLog.includes("pm2-manager activated"));
	const pluginErrors = serverLog
		.split(/\r?\n/)
		.filter((line) => line.includes(`[plugin:${PLUGIN_ID}]`) && /error|invalid|ignored|failed|reject/i.test(line));
	check("无插件运行时报错", pluginErrors.length === 0, pluginErrors.slice(0, 2).join(" | "));

	const statusRes = await fetch(`${BASE}/plugins-api/${PLUGIN_ID}/status`);
	const status = await statusRes.json().catch(() => null);
	check(
		"GET /status 回结构化状态",
		statusRes.ok &&
			typeof status?.installed === "boolean" &&
			status?.guardMode === undefined &&
			status?.platform === process.platform,
		JSON.stringify({ installed: status?.installed, platform: status?.platform }),
	);
	check(
		"未装 pm2 时给出安装路径（不崩）",
		status?.installed === true || String(status?.installCommand ?? "").includes("pm2"),
		String(status?.installCommand ?? status?.version ?? ""),
	);

	const bad = await postJson(`/plugins-api/${PLUGIN_ID}/action`, { action: "explode", name: "" });
	check("POST /action 挡非法入参", bad.json?.ok === false, JSON.stringify(bad.json?.error ?? ""));

	const gone = await postJson(`/plugins-api/${PLUGIN_ID}/scan`);
	check("已删的 /scan 真回 404（遗留实例交给宿主面板）", gone.status === 404, `status=${gone.status}`);
}

main()
	.catch((err) => {
		failures++;
		console.error(`✗ ${err?.stack ?? err}`);
	})
	.finally(async () => {
		try {
			sock?.close();
		} catch {}
		try {
			proc?.kill();
		} catch {}
		await new Promise((r) => setTimeout(r, 500));
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {}
		console.log(failures === 0 ? "\npm2-manager 插件 E2E 全过" : `\npm2-manager 插件 E2E 失败 ${failures} 项`);
		process.exit(failures === 0 ? 0 : 1);
	});
